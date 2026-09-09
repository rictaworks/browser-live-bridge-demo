require "rails_helper"

RSpec.describe "Internal::Broadcasts", type: :request do
  def create_broadcast!
    post "/api/broadcasts", params: { layout_preset: "screen_primary" }, as: :json
    JSON.parse(response.body)
  end

  describe "POST /internal/broadcasts/verify" do
    it "セッションキーと配信トークンの組が一致すれば有効と応答すること" do
      created = create_broadcast!

      post "/internal/broadcasts/verify",
           params: { session_key: created["session_key"], broadcast_token: created["broadcast_token"] }, as: :json

      expect(response).to have_http_status(:ok)
      body = JSON.parse(response.body)
      expect(body["valid"]).to eq(true)
      expect(body["broadcast_id"]).to eq(created["id"])
    end

    it "組み合わせが一致しなければ無効と応答すること（接続を確立させない）" do
      created = create_broadcast!

      post "/internal/broadcasts/verify",
           params: { session_key: created["session_key"], broadcast_token: "not-the-real-token" }, as: :json

      expect(response).to have_http_status(:ok)
      body = JSON.parse(response.body)
      expect(body["valid"]).to eq(false)
      expect(body["broadcast_id"]).to be_nil
    end
  end

  describe "POST /internal/broadcasts/:id/health_samples" do
    it "健全性サンプルを記録できること" do
      created = create_broadcast!

      post "/internal/broadcasts/#{created['id']}/health_samples",
           params: {
             broadcast_token: created["broadcast_token"],
             queue_ms: 120,
             sent_bitrate_kbps: 2200,
             target_bitrate_kbps: 2500,
             dropped_video_frames: 0,
             dropped_audio_frames: 0,
             state: "live"
           }, as: :json

      expect(response).to have_http_status(:created)
      expect(HealthSample.where(broadcast_id: created["id"]).count).to eq(1)
    end

    it "必須項目が無ければ422になること" do
      created = create_broadcast!

      post "/internal/broadcasts/#{created['id']}/health_samples",
           params: { broadcast_token: created["broadcast_token"], queue_ms: 100 }, as: :json

      expect(response).to have_http_status(:unprocessable_content)
    end

    it "broadcast_tokenが一致しなければ404になること（多層防御：id推測だけでは書き込めない）" do
      created = create_broadcast!

      post "/internal/broadcasts/#{created['id']}/health_samples",
           params: {
             broadcast_token: "not-the-real-token",
             queue_ms: 120,
             sent_bitrate_kbps: 2200,
             target_bitrate_kbps: 2500,
             state: "live"
           }, as: :json

      expect(response).to have_http_status(:not_found)
      expect(HealthSample.where(broadcast_id: created["id"]).count).to eq(0)
    end
  end

  describe "POST /internal/broadcasts/:id/events" do
    it "イベントを記録できること" do
      created = create_broadcast!

      post "/internal/broadcasts/#{created['id']}/events",
           params: { broadcast_token: created["broadcast_token"], event_type: "reconnecting", detail: "connection lost" }, as: :json

      expect(response).to have_http_status(:created)
      expect(BroadcastEvent.where(broadcast_id: created["id"], event_type: "reconnecting").count).to eq(1)
    end

    it "broadcast_tokenが一致しなければ404になること" do
      created = create_broadcast!

      post "/internal/broadcasts/#{created['id']}/events",
           params: { broadcast_token: "not-the-real-token", event_type: "reconnecting" }, as: :json

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /internal/broadcasts/:id/finish" do
    it "配信終了を記録し、配信ロックを解放すること" do
      created = create_broadcast!
      id = created["id"]
      expect(BroadcastLock.exists?(broadcast_id: id)).to be true

      post "/internal/broadcasts/#{id}/finish",
           params: { broadcast_token: created["broadcast_token"], reason: "relay_disconnected" }, as: :json

      expect(response).to have_http_status(:ok)
      broadcast = Broadcast.find(id)
      expect(broadcast.state).to eq("ended")
      expect(broadcast.ended_reason).to eq("relay_disconnected")
      expect(BroadcastLock.exists?(broadcast_id: id)).to be false
    end

    it "べき等であること" do
      created = create_broadcast!
      id = created["id"]

      post "/internal/broadcasts/#{id}/finish", params: { broadcast_token: created["broadcast_token"] }, as: :json
      post "/internal/broadcasts/#{id}/finish", params: { broadcast_token: created["broadcast_token"] }, as: :json

      expect(response).to have_http_status(:ok)
    end

    it "broadcast_tokenが一致しなければ404になり、配信は終了しないこと" do
      created = create_broadcast!
      id = created["id"]

      post "/internal/broadcasts/#{id}/finish", params: { broadcast_token: "not-the-real-token" }, as: :json

      expect(response).to have_http_status(:not_found)
      expect(Broadcast.find(id).state).not_to eq("ended")
    end
  end
end
