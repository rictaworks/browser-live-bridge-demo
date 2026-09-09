# オーナーキーによるスコープ限定を一元化するサービス（requirements.md 9節・21節、クラス図のSessionOwnerGuardに対応）。
class SessionOwnerGuard
  def self.scope(model_class, session_key)
    model_class.for_session(session_key)
  end

  def self.verify(session_key, broadcast_id)
    Broadcast.for_session(session_key).exists?(id: broadcast_id)
  end
end
