# セッション単位の配信ロック（requirements.md 9節）。
# 主キーがsession_idそのものであるため、1セッションにつき常に高々1件しか存在できない。
class BroadcastLock < ApplicationRecord
  self.primary_key = "session_id"

  belongs_to :session, foreign_key: :session_id, primary_key: :session_id, inverse_of: :broadcast_lock
  belongs_to :broadcast, inverse_of: false

  validates :session_id, presence: true
  validates :broadcast_id, presence: true, uniqueness: true
  validates :acquired_at, presence: true
  validates :heartbeat_at, presence: true
end
