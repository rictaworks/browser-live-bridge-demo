# 擬似視聴者数の時系列（requirements.md 11節・13〜14節）。
class CreateAudienceSamples < ActiveRecord::Migration[8.1]
  def change
    create_table :audience_samples, id: :string do |t|
      t.string :session_id, null: false
      t.string :broadcast_id, null: false
      t.datetime :sampled_at, null: false
      t.integer :viewer_count, null: false
    end

    add_index :audience_samples, :session_id
    add_index :audience_samples, %i[broadcast_id sampled_at]
  end
end
