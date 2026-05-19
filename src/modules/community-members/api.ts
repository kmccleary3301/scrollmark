import { createModuleInterceptor, projectUsers } from '@/core/extensions/module-platform';
import { User } from '@/types';

interface CommunityMembersResponse {
  data: {
    communityResults: {
      result: {
        __typename: 'Community';
        members_slice: {
          items_results: {
            result: User;
          }[];
        };
        moderators_slice: {
          items_results: {
            result: User;
          }[];
        };
      };
    };
  };
}

// https://twitter.com/i/api/graphql/gwNDrhzDr9kuoulEqgSQcQ/membersSliceTimeline_Query
// https://twitter.com/i/api/graphql/hIHwUEnebpLYLqFyZKGbPQ/moderatorsSliceTimeline_Query
export const CommunityMembersInterceptor = createModuleInterceptor<User[]>({
  moduleName: 'CommunityMembers',
  match: (req) => /\/graphql\/.+\/(members|moderators)SliceTimeline_Query/.test(req.url),
  parse: (_req, res) => {
    const json: CommunityMembersResponse = JSON.parse(res.responseText);
    const result = json.data.communityResults.result;
    return (result.members_slice ?? result.moderators_slice).items_results
      .map((item) => item.result)
      .filter((user): user is User => user.__typename === 'User');
  },
  project: (extName, users) => projectUsers(extName, users),
});
