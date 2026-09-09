require "rails_helper"

RSpec.describe "GET /health", type: :request do
  it "200を返すこと" do
    get "/health"

    expect(response).to have_http_status(:ok)
    expect(JSON.parse(response.body)).to eq("status" => "ok")
  end
end
