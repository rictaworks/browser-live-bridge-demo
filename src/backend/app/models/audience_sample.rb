# 擬似視聴者数の時系列（requirements.md 11節）。
class AudienceSample < ApplicationRecord
  include HasOpaqueId
  include SessionOwned

  belongs_to :broadcast, inverse_of: :audience_samples

  validates :sampled_at, presence: true
  validates :viewer_count, presence: true, numericality: { greater_than_or_equal_to: 0 }
end
