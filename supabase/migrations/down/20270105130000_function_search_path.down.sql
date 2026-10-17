-- Down for 20270105130000_function_search_path: back to no function-level search_path setting.
set local lock_timeout = '3s';

alter function public._sync_assert_key(text, text) reset search_path;
alter function public.catalog_search_doc(text, text, text) reset search_path;
alter function public.compute_item_snapshot(uuid, numeric) reset search_path;
