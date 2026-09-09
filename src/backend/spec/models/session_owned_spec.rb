require "rails_helper"

# 全テーブルにsession_idを持たせ、for_sessionを経由しない限り他セッションのレコードへ
# 到達できないことをモデル層で直接検証する（requirements.md 9節・21節、最重要）。
RSpec.describe SessionOwned do
  def create_session!(session_id)
    Session.create!(session_id: session_id, created_at: Time.current, last_seen_at: Time.current,
                     user_agent_class: "chrome")
  end

  let(:session_a) { create_session!(SecureRandom.hex(32)).session_id }
  let(:session_b) { create_session!(SecureRandom.hex(32)).session_id }

  let(:broadcast_a) do
    Broadcast.create!(session_id: session_a, broadcast_token: BroadcastTokenGenerator.generate,
                       layout_preset: "screen_primary", state: "live", started_at: Time.current)
  end
  let(:broadcast_b) do
    Broadcast.create!(session_id: session_b, broadcast_token: BroadcastTokenGenerator.generate,
                       layout_preset: "screen_primary", state: "live", started_at: Time.current)
  end

  it "Broadcast: for_sessionは自セッションのレコードのみを返すこと" do
    broadcast_a
    broadcast_b

    expect(Broadcast.for_session(session_a)).to contain_exactly(broadcast_a)
    expect(Broadcast.for_session(session_a).find_by(id: broadcast_b.id)).to be_nil
  end

  it "BroadcastSource: 他セッションのソース構成は見えないこと" do
    source_a = BroadcastSource.create!(session_id: session_a, broadcast_id: broadcast_a.id, kind: "camera",
                                        role: "wipe", enabled: true)
    BroadcastSource.create!(session_id: session_b, broadcast_id: broadcast_b.id, kind: "camera", role: "wipe",
                             enabled: true)

    expect(BroadcastSource.for_session(session_a)).to contain_exactly(source_a)
  end

  it "HealthSample: 他セッションの健全性ログは見えないこと" do
    sample_a = HealthSample.create!(session_id: session_a, broadcast_id: broadcast_a.id, sampled_at: Time.current,
                                     queue_ms: 100, sent_bitrate_kbps: 2000, target_bitrate_kbps: 2500, state: "live")
    HealthSample.create!(session_id: session_b, broadcast_id: broadcast_b.id, sampled_at: Time.current,
                          queue_ms: 100, sent_bitrate_kbps: 2000, target_bitrate_kbps: 2500, state: "live")

    expect(HealthSample.for_session(session_a)).to contain_exactly(sample_a)
  end

  it "BroadcastEvent: 他セッションのイベントは見えないこと" do
    event_a = BroadcastEvent.create!(session_id: session_a, broadcast_id: broadcast_a.id, occurred_at: Time.current,
                                      event_type: "started")
    BroadcastEvent.create!(session_id: session_b, broadcast_id: broadcast_b.id, occurred_at: Time.current,
                            event_type: "started")

    expect(BroadcastEvent.for_session(session_a)).to contain_exactly(event_a)
  end

  it "AudienceSample: 他セッションの視聴者数サンプルは見えないこと" do
    sample_a = AudienceSample.create!(session_id: session_a, broadcast_id: broadcast_a.id, sampled_at: Time.current,
                                       viewer_count: 3)
    AudienceSample.create!(session_id: session_b, broadcast_id: broadcast_b.id, sampled_at: Time.current,
                            viewer_count: 3)

    expect(AudienceSample.for_session(session_a)).to contain_exactly(sample_a)
  end

  it "ChatMessage: 他セッションのチャットは見えないこと" do
    message_a = ChatMessage.create!(session_id: session_a, broadcast_id: broadcast_a.id, posted_at: Time.current,
                                     author_label: "配信者", origin: "broadcaster", body: "hello")
    ChatMessage.create!(session_id: session_b, broadcast_id: broadcast_b.id, posted_at: Time.current,
                         author_label: "配信者", origin: "broadcaster", body: "hello")

    expect(ChatMessage.for_session(session_a)).to contain_exactly(message_a)
  end

  it "BroadcastLock: 主キーがsession_idそのものであり、1セッションにつき高々1件しか持てないこと" do
    BroadcastLock.create!(session_id: session_a, broadcast_id: broadcast_a.id, acquired_at: Time.current,
                           heartbeat_at: Time.current)

    expect do
      BroadcastLock.create!(session_id: session_a, broadcast_id: broadcast_b.id, acquired_at: Time.current,
                             heartbeat_at: Time.current)
    end.to raise_error(ActiveRecord::RecordNotUnique)
  end

  it "SessionOwnerGuard.verify: 他セッションのIDでは false になること" do
    broadcast_a

    expect(SessionOwnerGuard.verify(session_a, broadcast_a.id)).to be true
    expect(SessionOwnerGuard.verify(session_b, broadcast_a.id)).to be false
  end
end
