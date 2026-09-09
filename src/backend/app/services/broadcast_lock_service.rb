# 配信ロックの取得・生存通知による維持・途絶時の自動解放（requirements.md 9節・22節）。
class BroadcastLockService
  class LockConflict < StandardError; end

  # 生存通知が既定の間隔を仮定し、これより長く途絶えた場合に回収対象とする。
  # フロントエンドのハートビート間隔（数秒程度を想定）に対し十分な余裕を持たせた値。
  HEARTBEAT_STALE_AFTER = 30.seconds

  def self.acquire!(session_key, broadcast_id, now: Time.current)
    BroadcastLock.create!(
      session_id: session_key,
      broadcast_id: broadcast_id,
      acquired_at: now,
      heartbeat_at: now
    )
  rescue ActiveRecord::RecordNotUnique, ActiveRecord::RecordInvalid
    raise LockConflict
  end

  def self.heartbeat(session_key, broadcast_id, now: Time.current)
    lock = BroadcastLock.find_by(session_id: session_key, broadcast_id: broadcast_id)
    return false unless lock

    lock.update!(heartbeat_at: now)
    true
  end

  def self.release(session_key)
    BroadcastLock.where(session_id: session_key).delete_all
  end

  # 生存通知が途絶えたロックを解放し、対応する配信が進行中であれば失敗として終了させる。
  # 戻り値は回収したセッションキーの一覧（テスト・ログ用）。
  def self.release_stale!(now: Time.current, stale_after: HEARTBEAT_STALE_AFTER)
    reclaimed_session_keys = []

    BroadcastLock.where(heartbeat_at: ...(now - stale_after)).find_each do |lock|
      reclaim_one(lock, now)
      reclaimed_session_keys << lock.session_id
    end

    reclaimed_session_keys
  end

  def self.reclaim_one(lock, now)
    broadcast = Broadcast.find_by(id: lock.broadcast_id)
    if broadcast && !broadcast.ended?
      broadcast.update!(state: "failed", ended_reason: "lock_heartbeat_timeout", ended_at: now)
      BroadcastEvent.create!(
        session_id: broadcast.session_id,
        broadcast_id: broadcast.id,
        occurred_at: now,
        event_type: "lock_reclaimed",
        detail: "heartbeat timeout"
      )
    end
    lock.destroy
  end
  private_class_method :reclaim_one
end
