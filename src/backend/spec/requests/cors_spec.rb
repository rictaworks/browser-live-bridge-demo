require "rails_helper"

RSpec.describe "CORS", type: :request do
  # フロントエンド（Next.js、別オリジン）からcredentials付きでAPIを呼ぶ構成のため、
  # ブラウザのpreflight（OPTIONS）・本体レスポンスの双方にCORSヘッダが必要（issue #4）。
  let(:frontend_origin) { "http://localhost:3000" }

  it "許可済みオリジンからのpreflightにAccess-Control-Allow-Originとcredentials許可を返すこと" do
    process :options, "/api/broadcasts", headers: {
      "Origin" => frontend_origin,
      "Access-Control-Request-Method" => "POST",
      "Access-Control-Request-Headers" => "content-type"
    }

    expect(response).to have_http_status(:ok)
    expect(response.headers["Access-Control-Allow-Origin"]).to eq(frontend_origin)
    expect(response.headers["Access-Control-Allow-Credentials"]).to eq("true")
  end

  it "許可済みオリジンからの本体リクエストにもAccess-Control-Allow-Originを返すこと" do
    post "/api/broadcasts",
      params: { layout_preset: "screen_primary", title: "CORS確認" },
      as: :json,
      headers: { "Origin" => frontend_origin }

    expect(response).to have_http_status(:created)
    expect(response.headers["Access-Control-Allow-Origin"]).to eq(frontend_origin)
  end

  it "許可外オリジンにはAccess-Control-Allow-Originを返さないこと" do
    post "/api/broadcasts",
      params: { layout_preset: "screen_primary", title: "CORS確認" },
      as: :json,
      headers: { "Origin" => "http://evil.example.com" }

    expect(response.headers["Access-Control-Allow-Origin"]).to be_nil
  end
end
