-- ============================================================================
-- Track orders placed through an AI shopping agent. Run once in Supabase.
--
-- Some orders arrive carrying a note attribute named _agentClientInfo — a JSON
-- blob an agentic-commerce framework stamps on the cart when an AI assistant,
-- not a person clicking directly, drives the checkout. It looks like:
--   {"sessionId":"...","clientId":"...",
--    "clientInformation":{"platformSessionId":"...","platformUserId":"...",
--                         "conversationId":"..."}}
--
-- This adds columns to record that, and an RPC to count it over a window.
--
-- HONEST SCOPE, so the numbers are not misread:
--   * Capture is forward-only and webhook-only. The note attribute rides in on
--     the order webhook; the periodic GraphQL pull does not request note
--     attributes, and past orders were stored without them, so nothing before
--     the webhook change can be classified. A run of zeros for old dates means
--     "not measured", not "no agents".
--   * Presence of the attribute means an agent framework was on the session. An
--     empty conversationId (as in the sample) means the framework was present
--     but did not record a full chat — so read this as "agent-assisted", the
--     honest ceiling of what the data proves.
-- ============================================================================

alter table public.shop_orders add column if not exists is_agent boolean not null default false;
alter table public.shop_orders add column if not exists agent_client text;    -- clientId, groups repeat agents
alter table public.shop_orders add column if not exists agent_platform text;   -- platformUserId, the buyer behind the agent

create index if not exists shop_orders_agent_idx
  on public.shop_orders (created_at desc) where is_agent;

-- ---------------------------------------------------------------------------
-- Agent orders over a window: how many, how much they were worth, and whether
-- they convert differently from the rest.
-- ---------------------------------------------------------------------------
create or replace function public.agent_order_stats(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '15s'
as $$
declare result json;
begin
  with w as (
    select is_agent, total_price, agent_client, order_number, created_at
    from public.shop_orders
    where created_at >= p_from and created_at <= p_to
  ),
  tot as (select count(*) n, coalesce(sum(total_price),0) rev from w),
  ag  as (select count(*) n, coalesce(sum(total_price),0) rev,
                 count(distinct agent_client) clients from w where is_agent)
  select json_build_object(
    'orders_total',    (select n from tot),
    'orders_agent',    (select n from ag),
    'revenue_total',   round((select rev from tot)),
    'revenue_agent',   round((select rev from ag)),
    'agent_share_pct', case when (select n from tot) > 0
                            then round(100.0 * (select n from ag) / (select n from tot), 1) else 0 end,
    'agent_aov',       case when (select n from ag) > 0
                            then round((select rev from ag) / (select n from ag)) else null end,
    'human_aov',       case when (select n from tot) - (select n from ag) > 0
                            then round(((select rev from tot)-(select rev from ag))
                                       / ((select n from tot)-(select n from ag))) else null end,
    'distinct_agents', (select clients from ag),
    'recent', (select coalesce(json_agg(json_build_array(order_number, round(total_price), created_at)
                        order by created_at desc), '[]'::json)
               from (select * from w where is_agent order by created_at desc limit 20) t)
  ) into result;
  return result;
end $$;
grant execute on function public.agent_order_stats(timestamptz, timestamptz) to anon;

-- Verify — everything zero until the updated webhook has received agent orders:
--   select public.agent_order_stats(now() - interval '30 days', now());
