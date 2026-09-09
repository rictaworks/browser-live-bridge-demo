# 配信に紐づくソース構成（requirements.md 6.2節・13〜14節）。
class CreateBroadcastSources < ActiveRecord::Migration[8.1]
  def change
    create_table :broadcast_sources, id: :string do |t|
      t.string :session_id, null: false
      t.string :broadcast_id, null: false
      t.string :kind, null: false
      t.string :role, null: false
      t.boolean :enabled, null: false, default: true
      t.datetime :attached_at
      t.datetime :detached_at
      t.timestamps
    end

    add_index :broadcast_sources, :session_id
    add_index :broadcast_sources, :broadcast_id
    add_index :broadcast_sources, %i[broadcast_id kind], unique: true
  end
end
