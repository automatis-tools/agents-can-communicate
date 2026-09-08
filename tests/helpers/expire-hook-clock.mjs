// Test preload: expire a chosen hook child's budget; never changes its exit policy.
const participant = process.env.ACC_TEST_EXPIRE_PARTICIPANT;
if (participant && process.env.ACC_PARTICIPANT === participant) {
  const original = Date.now;
  let reads = 0;
  Date.now = () => original() + 6000 * reads++;
}
