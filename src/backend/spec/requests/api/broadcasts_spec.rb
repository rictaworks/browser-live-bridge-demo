require "rails_helper"

RSpec.describe "Api::Broadcasts", type: :request do
  def create_broadcast!(layout_preset: "screen_primary", title: "テスト配信", **extra)
    post "/api/broadcasts", params: { layout_preset: layout_preset, title: title, **extra }, as: :json
    JSON.parse(response.body)
  end

  describe "POST /api/broadcasts" do
    it "配信を作成し、配信ロックを取得できること" do
      body = create_broadcast!

      expect(response).to have_http_status(:created)
      expect(body["state"]).to eq("preparing")
      expect(body["broadcast_token"]).to be_present
      expect(body["layout_preset"]).to eq("screen_primary")
      expect(Broadcast.count).to eq(1)
      expect(BroadcastLock.count).to eq(1)
    end

    it "layout_presetが無ければ422になること" do
      post "/api/broadcasts", params: { title: "タイトルのみ" }, as: :json
      expect(response).to have_http_status(:unprocessable_content)
    end

    it "同一セッションから二重に配信を開始すると409になること（排他制御）" do
      create_broadcast!
      post "/api/broadcasts", params: { layout_preset: "camera_primary" }, as: :json

      expect(response).to have_http_status(:conflict)
      expect(Broadcast.count).to eq(1)
    end

    it "ハニーポットのフィールドが埋まっていると拒否されること（requirements.md 21節）" do
      post "/api/broadcasts", params: { layout_preset: "screen_primary", hp_field: "spam" }, as: :json

      expect(response).to have_http_status(:unprocessable_content)
      expect(Broadcast.count).to eq(0)
    end

    it "配信トークンがセッションキーから導出されていないこと" do
      body = create_broadcast!

      expect(body["broadcast_token"]).not_to include(body["session_key"])
      expect(body["broadcast_token"].length).to be >= 32
    end
  end

  describe "GET /api/broadcasts/:id" do
    it "本人のセッションからは配信状態を取得できること" do
      created = create_broadcast!

      get "/api/broadcasts/#{created['id']}"

      expect(response).to have_http_status(:ok)
      expect(JSON.parse(response.body)["id"]).to eq(created["id"])
    end

    it "存在しないIDでは404になること" do
      create_broadcast!

      get "/api/broadcasts/does-not-exist"

      expect(response).to have_http_status(:not_found)
    end
  end

  describe "POST /api/broadcasts/:id/sources" do
    it "ソース構成を追加・更新できること（配信を中断しない）" do
      created = create_broadcast!
      id = created["id"]

      post "/api/broadcasts/#{id}/sources", params: { kind: "camera", role: "wipe", enabled: true }, as: :json
      expect(response).to have_http_status(:ok)
      attached = JSON.parse(response.body)
      expect(attached["kind"]).to eq("camera")
      expect(attached["enabled"]).to eq(true)
      expect(attached["attached_at"]).to be_present

      post "/api/broadcasts/#{id}/sources", params: { kind: "camera", role: "wipe", enabled: false }, as: :json
      detached = JSON.parse(response.body)
      expect(detached["enabled"]).to eq(false)
      expect(detached["detached_at"]).to be_present
      expect(BroadcastSource.where(broadcast_id: id, kind: "camera").count).to eq(1)
    end

    it "未知のkindは422になること" do
      created = create_broadcast!

      post "/api/broadcasts/#{created['id']}/sources", params: { kind: "unknown", role: "wipe", enabled: true },
                                                         as: :json

      expect(response).to have_http_status(:unprocessable_content)
    end
  end

  describe "POST /api/broadcasts/:id/lock/heartbeat" do
    it "生存通知でロックを維持できること" do
      created = create_broadcast!
      lock = BroadcastLock.find(created["session_key"])
      original_heartbeat = lock.heartbeat_at

      travel_to(original_heartbeat + 5.seconds) do
        post "/api/broadcasts/#{created['id']}/lock/heartbeat", as: :json
      end

      expect(response).to have_http_status(:ok)
      expect(lock.reload.heartbeat_at).to be > original_heartbeat
    end
  end

  describe "POST /api/broadcasts/:id/stop" do
    it "配信を停止し、ロックを解放すること" do
      created = create_broadcast!
      id = created["id"]

      post "/api/broadcasts/#{id}/stop", params: { reason: "manual" }, as: :json

      expect(response).to have_http_status(:ok)
      body = JSON.parse(response.body)
      expect(body["state"]).to eq("ended")
      expect(body["ended_reason"]).to eq("manual")
      expect(BroadcastLock.exists?(session_id: created["session_key"])).to be false
    end

    it "べき等であること（二重に停止しても壊れない）" do
      created = create_broadcast!
      id = created["id"]

      post "/api/broadcasts/#{id}/stop", as: :json
      post "/api/broadcasts/#{id}/stop", as: :json

      expect(response).to have_http_status(:ok)
    end

    it "停止後は同一セッションから新しい配信を開始できること" do
      created = create_broadcast!
      post "/api/broadcasts/#{created['id']}/stop", as: :json

      post "/api/broadcasts", params: { layout_preset: "screen_primary" }, as: :json

      expect(response).to have_http_status(:created)
    end
  end

  describe "GET /api/broadcasts/:id/audience" do
    it "擬似視聴者数・擬似チャットを取得できること" do
      created = create_broadcast!

      get "/api/broadcasts/#{created['id']}/audience"

      expect(response).to have_http_status(:ok)
      body = JSON.parse(response.body)
      expect(body["simulated"]).to eq(true)
      expect(body["viewer_count"]).to be >= 0
      expect(body["messages"]).to be_an(Array)
    end
  end

  describe "POST /api/broadcasts/:id/chat" do
    it "配信者本人の投稿が生成分と区別して保持されること" do
      created = create_broadcast!
      id = created["id"]

      post "/api/broadcasts/#{id}/chat", params: { body: "こんにちは、配信者です" }, as: :json

      expect(response).to have_http_status(:created)
      body = JSON.parse(response.body)
      expect(body["origin"]).to eq("broadcaster")
      expect(body["author_label"]).to eq("配信者")

      get "/api/broadcasts/#{id}/audience"
      messages = JSON.parse(response.body)["messages"]
      expect(messages).to include(a_hash_including("origin" => "broadcaster", "body" => "こんにちは、配信者です"))
    end

    it "本文が空なら422になること" do
      created = create_broadcast!

      post "/api/broadcasts/#{created['id']}/chat", params: { body: "" }, as: :json

      expect(response).to have_http_status(:unprocessable_content)
    end
  end

  describe "GET /api/broadcasts/:id/events" do
    it "イベントログを取得できること" do
      created = create_broadcast!
      id = created["id"]
      post "/api/broadcasts/#{id}/stop", as: :json

      get "/api/broadcasts/#{id}/events"

      expect(response).to have_http_status(:ok)
      event_types = JSON.parse(response.body)["events"].map { |e| e["event_type"] }
      expect(event_types).to include("stopped")
    end
  end

  describe "セッションをまたいだアクセスの分離（requirements.md 9節・21節、最重要）" do
    it "他セッションからは参照・更新・削除に一切到達できないこと" do
      created = create_broadcast!
      id = created["id"]

      open_session do |intruder|
        intruder.get "/api/broadcasts/#{id}"
        expect(intruder.response).to have_http_status(:not_found)

        intruder.post "/api/broadcasts/#{id}/sources", params: { kind: "camera", role: "wipe", enabled: true },
                                                         as: :json
        expect(intruder.response).to have_http_status(:not_found)

        intruder.post "/api/broadcasts/#{id}/lock/heartbeat", as: :json
        expect(intruder.response).to have_http_status(:not_found)

        intruder.post "/api/broadcasts/#{id}/stop", as: :json
        expect(intruder.response).to have_http_status(:not_found)

        intruder.get "/api/broadcasts/#{id}/audience"
        expect(intruder.response).to have_http_status(:not_found)

        intruder.post "/api/broadcasts/#{id}/chat", params: { body: "乗っ取り投稿" }, as: :json
        expect(intruder.response).to have_http_status(:not_found)

        intruder.get "/api/broadcasts/#{id}/events"
        expect(intruder.response).to have_http_status(:not_found)
      end

      # 本人のセッションからは引き続き到達できることの対照確認
      get "/api/broadcasts/#{id}"
      expect(response).to have_http_status(:ok)
      expect(Broadcast.find(id).state).not_to eq("ended")
      expect(ChatMessage.where(broadcast_id: id, origin: "broadcaster")).to be_empty
    end

    it "他セッションが同時に配信ロックを取得しても互いに干渉しないこと" do
      create_broadcast!

      open_session do |other|
        other.post "/api/broadcasts", params: { layout_preset: "screen_primary" }, as: :json
        expect(other.response).to have_http_status(:created)
      end

      expect(BroadcastLock.count).to eq(2)
    end
  end
end
