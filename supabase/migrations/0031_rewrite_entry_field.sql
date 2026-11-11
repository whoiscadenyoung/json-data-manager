-- 0031: rewrite one field across a dataset's entries in one statement
-- (issue #292, currency typing).
--
-- "Type as currency" rewrites a text column's values to numbers. The values
-- are parsed CLIENT-side by the one shared parser (@caden/data-core/currency)
-- so the import flow, the schema editor and the views typing agree; this
-- function only applies the result, set-based, in chunks the caller sends:
--
--   p_values = [{ "id": <entry uuid>, "value": <json> | null }, ...]
--
-- A non-null value replaces data->field; a JSON null (or a missing "value")
-- removes the key (blank cells are dropped, never stored as 0). Ids from
-- another dataset are ignored (the dataset_id predicate), so a stale or
-- forged payload can't reach across datasets.
--
-- SECURITY INVOKER: RLS on entries gates every row (can_edit_dataset), a
-- view's rows stay read-only through the 0027 statement guard, and the
-- entries triggers keep the search vector, summaries and data_version
-- current exactly as for any other update. Returns the rows changed.

create function public.rewrite_entry_field(
  p_dataset uuid,
  p_field   text,
  p_values  jsonb
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_field is null or btrim(p_field) = '' then
    raise exception 'p_field must name a field';
  end if;
  if p_values is null or jsonb_typeof(p_values) is distinct from 'array' then
    raise exception 'p_values must be an array of {id, value}';
  end if;

  with payload as (
    select x.id, x.value
    from jsonb_to_recordset(p_values) as x(id uuid, value jsonb)
    where x.id is not null
  )
  update public.entries e
     set data = case
                  when p.value is null or jsonb_typeof(p.value) = 'null' then e.data - p_field
                  else jsonb_set(e.data, array[p_field], p.value, true)
                end
    from payload p
   where e.id = p.id
     and e.dataset_id = p_dataset;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.rewrite_entry_field(uuid, text, jsonb) from public, anon;
grant execute on function public.rewrite_entry_field(uuid, text, jsonb) to authenticated;
