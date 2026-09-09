require "rails_helper"

RSpec.describe ReclaimStaleLocksJob, type: :job do
  it "BroadcastLockService.release_stale!を呼び出すこと" do
    expect(BroadcastLockService).to receive(:release_stale!).with(now: instance_of(ActiveSupport::TimeWithZone))

    described_class.perform_now
  end
end
