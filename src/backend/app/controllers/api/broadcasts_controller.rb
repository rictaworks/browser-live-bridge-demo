# 配信者向けAPI（requirements.md 9節・11節・12.1節）。Cookieのセッションキーをオーナーキーとして
# 全操作をスコープする。認証・認可は組み込まない（requirements.md 21節）。
module Api
  class BroadcastsController < ApplicationController
    # POST /api/broadcasts
    # 配信作成＋配信ロック取得（requirements.md 9節・16.1節）。ロック取得に失敗した場合は409を返す。
    def create
      return render_bot_rejected if HoneypotGuard.bot?(params)

      layout_preset = params[:layout_preset]
      return render_layout_preset_required if layout_preset.blank?

      session_key = current_session_key
      return render_lock_conflict if BroadcastLock.exists?(session_id: session_key)

      broadcast = create_broadcast_with_lock!(session_key, layout_preset)
      render json: broadcast_json(broadcast), status: :created
    rescue BroadcastLockService::LockConflict
      render_lock_conflict
    end

    # GET /api/broadcasts/:id
    def show
      render json: broadcast_json(owned_broadcast!(params[:id]))
    end

    # POST /api/broadcasts/:id/sources
    # ソース構成の追加/更新（requirements.md 6.2節）。配信中の変更も配信を中断しない。
    def sources
      broadcast = owned_broadcast!(params[:id])
      source = upsert_source!(broadcast)
      render json: source_json(source)
    end

    # POST /api/broadcasts/:id/lock/heartbeat
    def heartbeat
      broadcast = owned_broadcast!(params[:id])
      ok = BroadcastLockService.heartbeat(current_session_key, broadcast.id)
      return render json: { error: "lock_not_found" }, status: :not_found unless ok

      render json: { ok: true, heartbeat_at: Time.current }
    end

    # POST /api/broadcasts/:id/stop
    def stop
      broadcast = owned_broadcast!(params[:id])
      stop_broadcast!(broadcast) unless broadcast.ended?
      render json: broadcast_json(broadcast)
    end

    # GET /api/broadcasts/:id/audience
    # 擬似視聴者数・擬似チャットの取得（決定的生成、requirements.md 11節）。
    def audience
      broadcast = owned_broadcast!(params[:id])
      render json: audience_json(broadcast)
    end

    # POST /api/broadcasts/:id/chat
    # 配信者本人の投稿。生成分と区別して保持・表示する（requirements.md 11節）。
    def chat
      broadcast = owned_broadcast!(params[:id])
      return render_body_required if params[:body].blank?

      message = broadcast.chat_messages.create!(
        session_id: broadcast.session_id,
        posted_at: Time.current,
        author_label: "配信者",
        origin: "broadcaster",
        body: params[:body]
      )
      render json: chat_message_json(message), status: :created
    end

    # GET /api/broadcasts/:id/events
    def events
      broadcast = owned_broadcast!(params[:id])
      events = broadcast.broadcast_events.order(:occurred_at).map do |event|
        { event_type: event.event_type, detail: event.detail, occurred_at: event.occurred_at }
      end
      render json: { events: events }
    end

    private

    def create_broadcast_with_lock!(session_key, layout_preset)
      broadcast = nil
      ActiveRecord::Base.transaction do
        broadcast = Broadcast.create!(
          session_id: session_key,
          broadcast_token: BroadcastTokenGenerator.generate,
          title: params[:title],
          layout_preset: layout_preset,
          state: "preparing",
          started_at: Time.current
        )
        BroadcastLockService.acquire!(session_key, broadcast.id)
      end
      broadcast
    end

    def upsert_source!(broadcast)
      source = broadcast.broadcast_sources.find_or_initialize_by(kind: params[:kind])
      was_enabled = source.persisted? && source.enabled
      now = Time.current
      enabled = cast_enabled(params[:enabled])

      source.session_id = broadcast.session_id
      source.role = params[:role]
      source.enabled = enabled.nil? ? true : enabled
      source.attached_at = now if source.enabled && !was_enabled
      source.detached_at = now if !source.enabled && was_enabled
      source.save!
      source
    end

    def cast_enabled(value)
      ActiveModel::Type::Boolean.new.cast(value)
    end

    def stop_broadcast!(broadcast)
      now = Time.current
      broadcast.update!(state: "ended", ended_reason: params[:reason].presence || "broadcaster_stop", ended_at: now)
      broadcast.broadcast_events.create!(
        session_id: broadcast.session_id,
        occurred_at: now,
        event_type: "stopped",
        detail: params[:reason]
      )
      BroadcastLockService.release(broadcast.session_id)
    end

    def audience_json(broadcast)
      elapsed = broadcast.elapsed_seconds
      {
        viewer_count: SimulatedAudienceService.viewer_count(broadcast.broadcast_token, elapsed),
        elapsed_seconds: elapsed,
        simulated: true,
        messages: combined_messages(broadcast, elapsed)
      }
    end

    def combined_messages(broadcast, elapsed)
      simulated = SimulatedAudienceService.messages_until(broadcast.broadcast_token, elapsed).map do |m|
        {
          author_label: m[:author_label],
          origin: "simulated",
          body: m[:body],
          posted_at: broadcast.started_at + m[:offset_seconds].seconds
        }
      end

      broadcaster_posts = broadcast.chat_messages.where(origin: "broadcaster").order(:posted_at).map do |message|
        chat_message_json(message)
      end

      (simulated + broadcaster_posts).sort_by { |m| m[:posted_at] }
    end

    def broadcast_json(broadcast)
      {
        id: broadcast.id,
        broadcast_token: broadcast.broadcast_token,
        state: broadcast.state,
        title: broadcast.title,
        layout_preset: broadcast.layout_preset,
        ended_reason: broadcast.ended_reason,
        started_at: broadcast.started_at,
        ended_at: broadcast.ended_at,
        # 中継サーバーへのWebSocket開始通知（requirements.md 6.6節）に載せるためのセッションキー。
        # セッションCookie自体はhttponlyでJSから読めないため、配信者本人のセッションに限りAPI応答へ
        # 明示的に含める（契約で定義された最小フィールドへの追加であり、これがないとフロントエンドが
        # 開始通知を組み立てられない）。
        session_key: broadcast.session_id
      }
    end

    def source_json(source)
      {
        id: source.id,
        kind: source.kind,
        role: source.role,
        enabled: source.enabled,
        attached_at: source.attached_at,
        detached_at: source.detached_at
      }
    end

    def chat_message_json(message)
      {
        id: message.id,
        author_label: message.author_label,
        origin: message.origin,
        body: message.body,
        posted_at: message.posted_at
      }
    end

    def render_bot_rejected
      render json: { error: "invalid_request" }, status: :unprocessable_content
    end

    def render_layout_preset_required
      render json: { error: "layout_preset is required" }, status: :unprocessable_content
    end

    def render_body_required
      render json: { error: "body is required" }, status: :unprocessable_content
    end

    def render_lock_conflict
      render json: { error: "lock_conflict" }, status: :conflict
    end
  end
end
