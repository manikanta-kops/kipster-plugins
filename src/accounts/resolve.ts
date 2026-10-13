export interface Candidate {
  id: string
  label: string
}
// "Repos under acme/ use work": targets starting with prefix use account (id or label).
export interface RoutingRule {
  prefix: string
  account: string
}
export interface ResolveInput<A extends Candidate> {
  accounts: A[]
  // 1. The account the caller passed, by id or label (case-insensitive).
  requested?: string
  // 2. Routing rules matched against target; the longest prefix wins.
  rules?: RoutingRule[]
  target?: string
  // 3. Ids of the accounts that can reach target; undefined when unknown.
  reachable?: string[]
  // 4. The plugin's default account id.
  defaultId?: string
}
export type Resolution<A extends Candidate> =
  | {
      result: 'account'
      account: A
      reason: 'requested' | 'rule' | 'reachable' | 'default' | 'only'
    }
  | { result: 'ambiguous'; candidates: string[] }
  | { result: 'unknown-account'; requested: string; candidates: string[] }
  | { result: 'no-account' }

function find<A extends Candidate>(accounts: A[], key: string): A | undefined {
  return (
    accounts.find((a) => a.id === key) ??
    accounts.find((a) => a.label.toLowerCase() === key.toLowerCase())
  )
}
// Pure: the plan's order, then "ambiguous" with the remaining candidates' labels.
export function resolveAccount<A extends Candidate>(
  input: ResolveInput<A>,
): Resolution<A> {
  const { accounts } = input
  if (!accounts.length) return { result: 'no-account' }
  const labels = (list: A[]) => list.map((a) => a.label)
  if (input.requested !== undefined) {
    const account = find(accounts, input.requested)
    return account
      ? { result: 'account', account, reason: 'requested' }
      : {
          result: 'unknown-account',
          requested: input.requested,
          candidates: labels(accounts),
        }
  }
  if (input.target !== undefined) {
    const rule = (input.rules ?? [])
      .filter((r) => input.target!.startsWith(r.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)
      .map((r) => find(accounts, r.account))
      .find(Boolean)
    if (rule) return { result: 'account', account: rule, reason: 'rule' }
  }
  const reachable = input.reachable
    ? accounts.filter((a) => input.reachable!.includes(a.id))
    : []
  if (reachable.length === 1)
    return { result: 'account', account: reachable[0]!, reason: 'reachable' }
  const candidates = reachable.length ? reachable : accounts
  const fallback = candidates.find((a) => a.id === input.defaultId)
  if (fallback)
    return { result: 'account', account: fallback, reason: 'default' }
  if (accounts.length === 1)
    return { result: 'account', account: accounts[0]!, reason: 'only' }
  return { result: 'ambiguous', candidates: labels(candidates) }
}
