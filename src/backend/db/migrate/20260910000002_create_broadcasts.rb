# 配信1本（requirements.md 13〜14節）。
# broadcast_token はモニターURL用の推測不可能な識別子で、session_idから導出しない（9節・21節）。
class CreateBroadcasts < ActiveRecord::Migration[8.1]
  def change
    create_table :broadcasts, id: :string do |t|
      t.string :session_id, null: false
      t.string :broadcast_token, null: false
      t.string :title
      t.string :layout_preset, null: false
      t.string :state, null: false, default: "preparing"
      t.string :ended_reason
      t.datetime :started_at, null: false
      t.datetime :ended_at
      t.timestamps
    end

    add_index :broadcasts, :session_id
    add_index :broadcasts, :broadcast_token, unique: true
  end
end
