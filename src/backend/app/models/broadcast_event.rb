# 配信中に発生した事象（requirements.md 8節・12.1節イベントログ）。
class BroadcastEvent < ApplicationRecord
  include HasOpaqueId
  include SessionOwned

  belongs_to :broadcast, inverse_of: :broadcast_events

  validates :occurred_at, presence: true
  validates :event_type, presence: true
end
