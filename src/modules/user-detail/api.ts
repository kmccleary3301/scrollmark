import { createModuleInterceptor, projectUsers } from '@/core/extensions/module-platform';
import { User } from '@/types';

interface UserDetailResponse {
  data: {
    user: {
      result: User;
    };
  };
}

// https://twitter.com/i/api/graphql/BQ6xjFU6Mgm-WhEP3OiT9w/UserByScreenName
export const UserDetailInterceptor = createModuleInterceptor<User[]>({
  moduleName: 'UserDetail',
  match: (req) => /\/graphql\/.+\/UserByScreenName/.test(req.url),
  parse: (_req, res) => {
    const json: UserDetailResponse = JSON.parse(res.responseText);
    return [json.data.user.result];
  },
  project: (extName, users) => projectUsers(extName, users),
});
