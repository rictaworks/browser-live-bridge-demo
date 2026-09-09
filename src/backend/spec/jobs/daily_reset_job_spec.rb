require "rails_helper"

RSpec.describe DailyResetJob, type: :job do
  it "停止要求のあとに全テーブルを削除すること（テスト環境では猶予時間のsleepを行わない）" do
    session = Session.create!(session_id: SecureRandom.hex(32), created_at: Time.current, last_seen_at: Time.current,
                               user_agent_class: "chrome")
    broadcast = Broadcast.create!(session_id: session.session_id, broadcast_token: BroadcastTokenGenerator.generate,
                                   layout_preset: "screen_primary", state: "live", started_at: Time.current)

    described_class.perform_now

    expect(Broadcast.exists?(broadcast.id)).to be false
    expect(Session.exists?(session.session_id)).to be false
  end
end
