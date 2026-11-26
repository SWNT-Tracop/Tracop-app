import { DomainError } from '../../../shared/kernel/domain-error.js';
import { failure, success } from '../../../shared/kernel/result.js';
import { ChannelOnboardingService } from './channel-onboarding-service.js';

const command = { channel: 'telegram' as const, channelUserId: '900001', phone: '+573001234567' };

const harness = (outcome: Awaited<ReturnType<ChannelOnboardingService['linkChannel']>>) => {
  const issued: string[] = [];
  const service = new ChannelOnboardingService(
    { linkChannel: async () => outcome },
    {
      issueCodeForNewChannelLink: async (phone) => {
        issued.push(phone);
        return '123456';
      },
    },
  );
  return { service, issued };
};

describe('ChannelOnboardingService', () => {
  it('issues the sign-in code only for a newly linked chat', async () => {
    const linked = harness(success({ status: 'linked', userId: 'u-1' }));
    expect(await linked.service.linkChannel(command)).toEqual(
      success({ status: 'linked', userId: 'u-1', code: '123456' }),
    );
    expect(linked.issued).toEqual([command.phone]);

    const again = harness(success({ status: 'already_linked', userId: 'u-1' }));
    expect(await again.service.linkChannel(command)).toEqual(
      success({ status: 'already_linked', userId: 'u-1' }),
    );
    expect(again.issued).toEqual([]);
  });

  it('passes a failed link through without issuing a code', async () => {
    const error = new DomainError(
      'Este canal ya está vinculado a otra cuenta.',
      'channel_already_linked',
    );
    const failed = harness(failure(error));
    expect(await failed.service.linkChannel(command)).toEqual(failure(error));
    expect(failed.issued).toEqual([]);
  });

  it('links without a code when none can be issued', async () => {
    const service = new ChannelOnboardingService(
      { linkChannel: async () => success({ status: 'linked', userId: 'u-1' }) },
      { issueCodeForNewChannelLink: async () => null },
    );
    expect(await service.linkChannel(command)).toEqual(
      success({ status: 'linked', userId: 'u-1' }),
    );
  });
});
