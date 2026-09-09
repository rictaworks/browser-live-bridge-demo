# 日次リセット（requirements.md 22節・16.5節）。JST 03:00に、進行中の配信へ停止要求を出し、
# 猶予時間の経過後に全テーブルを削除する。
#
# ここで行う削除はすべてActiveRecord経由のDBレコード削除であり、CLAUDE.mdが禁止する
# ファイル・ディレクトリ削除コマンド（rm等）とは無関係で、通常のドメインロジックとして実装する。
class DailyResetService
  RESET_HOUR_JST = 3
  DEFAULT_GRACE_PERIOD = 30.seconds

  # 進行中の配信へ停止要求を出す。実際の終了記録（state: ended）は、配信者・中継側からの
  # 通常のPOST /api/broadcasts/:id/stopないしPOST /internal/broadcasts/:id/finishに委ねる。
  def self.request_stop_all!(now: Time.current)
    Broadcast.where(state: Broadcast::ACTIVE_STATES).find_each do |broadcast|
      broadcast.update!(state: "stopping")
      BroadcastEvent.create!(
        session_id: broadcast.session_id,
        broadcast_id: broadcast.id,
        occurred_at: now,
        event_type: "daily_reset_stop_requested",
        detail: nil
      )
    end
  end

  # 猶予時間の経過後に呼び出す。8テーブルすべてを削除し、配信ロックも解放する。
  def self.purge_all!
    ChatMessage.delete_all
    AudienceSample.delete_all
    BroadcastEvent.delete_all
    HealthSample.delete_all
    BroadcastSource.delete_all
    BroadcastLock.delete_all
    Broadcast.delete_all
    Session.delete_all
  end

  # JST 03:00台に到達し、かつ本日まだ実行していないかどうかを判定する（実行トリガーの純粋な判定ロジック）。
  # 実際にJST 03:00を待たずとも、任意の`now`を渡すことで単体テストできる。
  def self.due?(now: Time.current, last_run_on: nil)
    jst_now = now.in_time_zone("Asia/Tokyo")
    jst_now.hour == RESET_HOUR_JST && last_run_on != jst_now.to_date
  end
end
