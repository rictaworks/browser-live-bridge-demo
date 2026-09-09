# 配信ロックの自動解放（requirements.md 9節）と日次リセット（requirements.md 22節）の定期実行。
#
# このスキャフォールドにはsolid_queueのrecurring.yml向けテーブルがまだセットアップされていないため
# （Gemfileには含まれるが、本issueのスコープはアプリケーション層のドメインロジックに限定した）、
# デモ用途として軽量なバックグラウンドスレッドで代替する。本番相当の運用に発展させる場合は、
# solid_queueのrecurring.yml等、永続化されたスケジューラへ置き換えることを推奨する。
#
# ロジック本体（BroadcastLockService / DailyResetService）は、このスレッドの起動有無に関わらず
# 単体テストできるように分離してある。テスト・コンソール・rakeタスク実行時はスレッドを起動しない。
return if Rails.env.test?

Rails.application.config.after_initialize do
  next unless defined?(Rails::Server)

  Thread.new do
    last_daily_reset_on = nil

    loop do
      sleep 10

      begin
        BroadcastLockService.release_stale!
      rescue StandardError => e
        Rails.logger.error("[BroadcastLockService] release_stale! failed: #{e.class}: #{e.message}")
      end

      begin
        if DailyResetService.due?(last_run_on: last_daily_reset_on)
          DailyResetJob.perform_now
          last_daily_reset_on = Time.current.in_time_zone("Asia/Tokyo").to_date
        end
      rescue StandardError => e
        Rails.logger.error("[DailyResetService] daily reset failed: #{e.class}: #{e.message}")
      end
    end
  end
end
