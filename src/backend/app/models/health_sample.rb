# 健全性の時系列（requirements.md 7節）。中継からの内部APIで記録される。
class HealthSample < ApplicationRecord
  include HasOpaqueId
  include SessionOwned

  belongs_to :broadcast, inverse_of: :health_samples

  validates :sampled_at, presence: true
  validates :queue_ms, :sent_bitrate_kbps, :target_bitrate_kbps, presence: true
  validates :state, presence: true
end
