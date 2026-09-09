require "rails_helper"

RSpec.describe DailyResetService do
  def create_broadcast!(state: "live")
    session = Session.create!(session_id: SecureRandom.hex(32), created_at: Time.current, last_seen_at: Time.current,
                               user_agent_class: "chrome")
    broadcast = Broadcast.create!(
      session_id: session.session_id,
      broadcast_token: BroadcastTokenGenerator.generate,
      layout_preset: "screen_primary",
      state: state,
      started_at: Time.current
    )
    BroadcastLockService.acquire!(session.session_id, broadcast.id)
    HealthSample.create!(session_id: session.session_id, broadcast_id: broadcast.id, sampled_at: Time.current,
                          queue_ms: 100, sent_bitrate_kbps: 2000, target_bitrate_kbps: 2500, state: "live")
    BroadcastEvent.create!(session_id: session.session_id, broadcast_id: broadcast.id, occurred_at: Time.current,
                            event_type: "started")
    AudienceSample.create!(session_id: session.session_id, broadcast_id: broadcast.id, sampled_at: Time.current,
                            viewer_count: 5)
    ChatMessage.create!(session_id: session.session_id, broadcast_id: broadcast.id, posted_at: Time.current,
                         author_label: "視聴者-AAAA", origin: "simulated", body: "こんにちは！")
    BroadcastSource.create!(session_id: session.session_id, broadcast_id: broadcast.id, kind: "screen",
                             role: "primary", enabled: true)
    broadcast
  end

  describe ".request_stop_all!" do
    it "進行中の配信へ停止要求を出すこと（requirements.md 22節・16.5節）" do
      live = create_broadcast!(state: "live")
      already_ended = create_broadcast!(state: "ended")

      described_class.request_stop_all!

      expect(live.reload.state).to eq("stopping")
      expect(live.broadcast_events.where(event_type: "daily_reset_stop_requested")).to be_present
      expect(already_ended.reload.state).to eq("ended")
      expect(already_ended.broadcast_events.where(event_type: "daily_reset_stop_requested")).to be_empty
    end
  end

  describe ".purge_all!" do
    it "8テーブルすべてのレコードを削除すること" do
      create_broadcast!

      expect(Session.count).to be > 0
      expect(Broadcast.count).to be > 0
      expect(BroadcastLock.count).to be > 0
      expect(HealthSample.count).to be > 0
      expect(BroadcastEvent.count).to be > 0
      expect(AudienceSample.count).to be > 0
      expect(ChatMessage.count).to be > 0
      expect(BroadcastSource.count).to be > 0

      described_class.purge_all!

      expect(Session.count).to eq(0)
      expect(Broadcast.count).to eq(0)
      expect(BroadcastLock.count).to eq(0)
      expect(HealthSample.count).to eq(0)
      expect(BroadcastEvent.count).to eq(0)
      expect(AudienceSample.count).to eq(0)
      expect(ChatMessage.count).to eq(0)
      expect(BroadcastSource.count).to eq(0)
    end
  end

  describe ".due?" do
    it "JST 03:00台であれば true を返すこと（実時計を待たずロジックを直接検証）" do
      jst_3am = Time.utc(2026, 9, 10, 18, 30) # UTC 18:30 = JST 03:30

      expect(described_class.due?(now: jst_3am)).to be true
    end

    it "JST 03:00台以外は false を返すこと" do
      jst_noon = Time.utc(2026, 9, 10, 3, 0) # UTC 3:00 = JST 12:00

      expect(described_class.due?(now: jst_noon)).to be false
    end

    it "同じ日に既に実行済みなら false を返すこと（多重実行の防止）" do
      jst_3am = Time.utc(2026, 9, 10, 18, 30)
      already_run_on = jst_3am.in_time_zone("Asia/Tokyo").to_date

      expect(described_class.due?(now: jst_3am, last_run_on: already_run_on)).to be false
    end
  end
end
