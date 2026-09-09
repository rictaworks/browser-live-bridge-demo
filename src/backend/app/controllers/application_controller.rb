# 全コントローラー共通の基底クラス。/api/** はここを継承し、Cookieのセッションキーを
# オーナーキーとして一元的に扱う（requirements.md 9節・21節）。
class ApplicationController < ActionController::API
  rescue_from ActiveRecord::RecordNotFound, with: :render_not_found
  rescue_from ActiveRecord::RecordInvalid, with: :render_unprocessable
  rescue_from ActionController::ParameterMissing, with: :render_parameter_missing

  private

  # Cookie（httponly, same_site: :lax）に保持したセッションキーを返す。未発行なら発行し、
  # sessionsテーブルへupsertする。ActionController::API はRackDelegationを持たないため、
  # `session` ではなく `request.session` を直接介して読み書きする。
  def current_session_key
    @current_session_key ||= begin
      key = request.session[:session_key] ||= SecureRandom.hex(32)
      touch_session!(key)
      key
    end
  end

  def touch_session!(key)
    now = Time.current
    record = Session.find_or_initialize_by(session_id: key)
    record.created_at ||= now
    record.last_seen_at = now
    record.user_agent_class = UserAgentClassifier.classify(request.user_agent)
    record.save!
  end

  # セッションをまたいだ参照・更新・削除を一切許可しないための共通ヘルパー（requirements.md 9節）。
  # 他セッションのIDを指定した場合はActiveRecord::RecordNotFoundとなり、存在の有無も漏らさない。
  def owned_broadcast!(id)
    Broadcast.for_session(current_session_key).find(id)
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
