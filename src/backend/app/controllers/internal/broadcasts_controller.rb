# 中継（Gin）↔アプリケーション（Rails）内部API（requirements.md 2.3節・6.6節・6.7節）。
#
# Railway内部通信のみを想定し外部公開しない。資格情報を要する外部通信ではないため
# requirements.md 21節（オーナーキー・トークンによる保護）の直接の対象外だが、
# 多層防御として、health_samples/events/finishはverifyと同様にid×broadcast_tokenの
# 組が一致するレコードのみを対象とする（idだけの推測では書き込めないようにする）。
module Internal
  class BroadcastsController < ActionController::API
    rescue_from ActiveRecord::RecordNotFound, with: :render_not_found
    rescue_from ActiveRecord::RecordInvalid, with: :render_unprocessable
    rescue_from ActionController::ParameterMissing, with: :render_parameter_missing

    # POST /internal/broadcasts/verify
    # 開始通知のセッションキーと配信トークンの組がレコードと一致するかを照合する（requirements.md 6.6節）。
    def verify
      broadcast = Broadcast.find_by(session_id: params[:session_key], broadcast_token: params[:broadcast_token])
      render json: { valid: broadcast.present?, broadcast_id: broadcast&.id }
    end

    # POST /internal/broadcasts/:id/health_samples
    def health_samples
      broadcast = find_verified_broadcast!
      broadcast.health_samples.create!(
        session_id: broadcast.session_id,
        sampled_at: Time.current,
        queue_ms: params.require(:queue_ms),
        sent_bitrate_kbps: params.require(:sent_bitrate_kbps),
        target_bitrate_kbps: params.require(:target_bitrate_kbps),
        dropped_video_frames: params[:dropped_video_frames] || 0,
        dropped_audio_frames: params[:dropped_audio_frames] || 0,
        state: params.require(:state)
      )
      render json: { ok: true }, status: :created
    end

    # POST /internal/broadcasts/:id/events
    def events
      broadcast = find_verified_broadcast!
      broadcast.broadcast_events.create!(
        session_id: broadcast.session_id,
        occurred_at: Time.current,
        event_type: params.require(:event_type),
        detail: params[:detail]
      )
      render json: { ok: true }, status: :created
    end

    # POST /internal/broadcasts/:id/finish
    # 配信終了記録・ロック解放（requirements.md 16.1節・16.5節）。
    def finish
      broadcast = find_verified_broadcast!
      unless broadcast.ended?
        broadcast.update!(
          state: "ended",
          ended_reason: params[:reason].presence || "relay_finish",
          ended_at: Time.current
        )
        broadcast.broadcast_events.create!(
          session_id: broadcast.session_id,
          occurred_at: Time.current,
          event_type: "finished",
          detail: params[:reason]
        )
      end
      BroadcastLockService.release(broadcast.session_id)
      render json: { ok: true }
    end

    private

    # id×broadcast_tokenの組が一致するレコードのみを返す（多層防御）。
    def find_verified_broadcast!
      Broadcast.find_by!(id: params[:id], broadcast_token: params.require(:broadcast_token))
    end

    def render_not_found
      render json: { error: "not_found" }, status: :not_found
    end

    def render_unprocessable(exception)
      render json: { error: "invalid", details: exception.record.errors.full_messages }, status: :unprocessable_content
    end

    def render_parameter_missing(exception)
      render json: { error: "invalid", details: [ exception.message ] }, status: :unprocessable_content
    end
  end
end
