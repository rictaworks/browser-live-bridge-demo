# 健全性の時系列（requirements.md 7節・13〜14節）。中継からの内部APIで記録される。
class CreateHealthSamples < ActiveRecord::Migration[8.1]
  def change
    create_table :health_samples, id: :string do |t|
      t.string :session_id, null: false
      t.string :broadcast_id, null: false
      t.datetime :sampled_at, null: false
      t.integer :queue_ms, null: false
      t.integer :sent_bitrate_kbps, null: false
      t.integer :target_bitrate_kbps, null: false
      t.integer :dropped_video_frames, null: false, default: 0
      t.integer :dropped_audio_frames, null: false, default: 0
      t.string :state, null: false
    end

    add_index :health_samples, :session_id
    add_index :health_samples, %i[broadcast_id sampled_at]
  end
end
