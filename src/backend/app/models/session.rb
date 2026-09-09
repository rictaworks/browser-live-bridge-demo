# ブラウザごとのセッション（requirements.md 13〜14節）。
# 主キーはCookieに保持する不透明なセッションキーそのもの。
class Session < ApplicationRecord
  self.primary_key = "session_id"

  has_many :broadcasts, foreign_key: :session_id, inverse_of: :session, dependent: nil
  has_one :broadcast_lock, foreign_key: :session_id, inverse_of: :session, dependent: nil

  validates :session_id, presence: true
  validates :user_agent_class, presence: true
end
