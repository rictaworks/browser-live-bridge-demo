# 配信中に発生した事象（requirements.md 8節・12.1節イベントログ・13〜14節）。
class CreateBroadcastEvents < ActiveRecord::Migration[8.1]
  def change
    create_table :broadcast_events, id: :string do |t|
      t.string :session_id, null: false
      t.string :broadcast_id, null: false
      t.datetime :occurred_at, null: false
      t.string :event_type, null: false
      t.string :detail
    end

    add_index :broadcast_events, :session_id
    add_index :broadcast_events, %i[broadcast_id occurred_at]
  end
end
