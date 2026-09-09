# 日次リセットジョブ（requirements.md 22節・16.5節）。ロジック本体はDailyResetServiceに置き、
# ジョブは停止要求 → 猶予時間の経過待ち → 全テーブル削除、の順序を制御するだけの薄い層とする。
class DailyResetJob < ApplicationJob
  queue_as :default

  def perform(now: Time.current, grace_period: DailyResetService::DEFAULT_GRACE_PERIOD)
    DailyResetService.request_stop_all!(now: now)
    sleep(grace_period) if grace_period.to_f.positive? && !Rails.env.test?
    DailyResetService.purge_all!
  end
end
