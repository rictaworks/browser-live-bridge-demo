# 配信に紐づくソース構成（requirements.md 6.2節）。
class BroadcastSource < ApplicationRecord
  include HasOpaqueId
  include SessionOwned

  KINDS = %w[screen camera mic tab_audio test].freeze
  ROLES = %w[primary wipe audio].freeze

  belongs_to :broadcast, inverse_of: :broadcast_sources

  validates :kind, presence: true, inclusion: { in: KINDS }
  validates :role, presence: true, inclusion: { in: ROLES }
  validates :kind, uniqueness: { scope: :broadcast_id }
end
