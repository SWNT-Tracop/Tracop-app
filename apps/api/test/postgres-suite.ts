export const describePostgres =
  process.env.TRACOP_TESTCONTAINER_AVAILABLE === 'true' ? describe : describe.skip;
