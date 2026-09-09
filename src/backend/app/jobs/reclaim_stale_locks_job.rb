# 配信ロックの自動解放ジョブ（requirements.md 9節）。ロジック本体はBroadcastLockServiceに置き、
# ジョブはそれを起動するだけの薄い層とする（単体テストしやすくするため）。
class ReclaimStaleLocksJob < ApplicationJob
  queue_as :default

  def perform(now: Time.current)
    BroadcastLockService.release_stale!(now: now)
  end
end
