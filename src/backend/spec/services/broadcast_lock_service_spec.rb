require "rails_helper"

RSpec.describe BroadcastLockService do
  def create_broadcast!(session_id: SecureRandom.hex(32))
    Session.find_or_create_by!(session_id: session_id) do |s|
      s.created_at = Time.current
      s.last_seen_at = Time.current
      s.user_agent_class = "chrome"
    end
    Broadcast.create!(
      session_id: session_id,
      broadcast_token: BroadcastTokenGenerator.generate,
      layout_preset: "screen_primary",
      state: "preparing",
      started_at: Time.current
    )
  end

  describe ".acquire!" do
    it "ロックを取得できること" do
      broadcast = create_broadcast!

      described_class.acquire!(broadcast.session_id, broadcast.id)

      expect(BroadcastLock.exists?(session_id: broadcast.session_id, broadcast_id: broadcast.id)).to be true
    end

    it "同一セッションが既にロックを保持している場合は失敗すること（排他制御、requirements.md 9節）" do
      broadcast1 = create_broadcast!
      described_class.acquire!(broadcast1.session_id, broadcast1.id)

      broadcast2 = create_broadcast!(session_id: broadcast1.session_id)

      expect do
        described_class.acquire!(broadcast2.session_id, broadcast2.id)
      end.to raise_error(BroadcastLockService::LockConflict)
    end
  end

  describe ".heartbeat" do
    it "本人のロックの生存通知時刻を更新できること" do
      broadcast = create_broadcast!
      described_class.acquire!(broadcast.session_id, broadcast.id)

      later = 10.seconds.from_now
      result = described_class.heartbeat(broadcast.session_id, broadcast.id, now: later)

      expect(result).to be true
      expect(BroadcastLock.find(broadcast.session_id).heartbeat_at).to be_within(1).of(later)
    end

    it "ロックが存在しなければfalseを返すこと" do
      result = described_class.heartbeat("no-such-session", "no-such-broadcast")

      expect(result).to be false
    end
  end

  describe ".release" do
    it "指定セッションのロックを解放すること" do
      broadcast = create_broadcast!
      described_class.acquire!(broadcast.session_id, broadcast.id)

      described_class.release(broadcast.session_id)

      expect(BroadcastLock.exists?(session_id: broadcast.session_id)).to be false
    end
  end

  describe ".release_stale!" do
    it "生存通知が途絶えたロックを解放し、対応する配信を失敗として終了させること（実時計を待たずロジックを直接検証）" do
      broadcast = create_broadcast!
      acquired_at = Time.current
      described_class.acquire!(broadcast.session_id, broadcast.id, now: acquired_at)

      check_time = acquired_at + BroadcastLockService::HEARTBEAT_STALE_AFTER + 1.second
      reclaimed = described_class.release_stale!(now: check_time)

      expect(reclaimed).to include(broadcast.session_id)
      expect(BroadcastLock.exists?(session_id: broadcast.session_id)).to be false

      broadcast.reload
      expect(broadcast.state).to eq("failed")
      expect(broadcast.ended_reason).to eq("lock_heartbeat_timeout")
      expect(broadcast.broadcast_events.where(event_type: "lock_reclaimed")).to be_present
    end

    it "生存通知が十分新しいロックは回収しないこと" do
      broadcast = create_broadcast!
      acquired_at = Time.current
      described_class.acquire!(broadcast.session_id, broadcast.id, now: acquired_at)

      reclaimed = described_class.release_stale!(now: acquired_at + 1.second)

      expect(reclaimed).to be_empty
      expect(BroadcastLock.exists?(session_id: broadcast.session_id)).to be true
    end
  end
end
