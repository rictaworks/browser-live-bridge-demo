# ブラウザごとのセッション（requirements.md 13〜14節）。
# session_id はCookieの値そのもの（不透明文字列）で、全テーブルのオーナーキーの起点。
class CreateSessions < ActiveRecord::Migration[8.1]
  def change
    create_table :sessions, id: :string, primary_key: :session_id do |t|
      t.datetime :created_at, null: false
      t.datetime :last_seen_at, null: false
      t.string :user_agent_class, null: false, default: "unknown"
    end
  end
end
