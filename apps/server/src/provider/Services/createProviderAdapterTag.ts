import { ServiceMap } from "effect";

export function createProviderAdapterTag<TSelf, TShape>(name: string) {
  return ServiceMap.Service<TSelf, TShape>()(name);
}
