-- Calculation audit S1 (2026-10-05): a shopping accept must never overwrite a recipe the user
-- already accepted for a slot. The shopping preview now keeps such a slot (its choice carries
-- `keptSelectionId`) and every choice names the accepted selection it expects to replace
-- (`expectedSelectionId`, null for an open slot). `recipe_accept_preview` verifies both:
--   * a kept choice must still find that exact live selection (id, plan revision, recipe
--     revision, serving); it is returned unchanged and never rewritten;
--   * a shopping choice never replaces a live selection, and a recipe choice that names its
--     expected selection replaces only that one. A recipe proof stored before this migration
--     carries no `expectedSelectionId` and keeps its old plan-revision check alone.
-- A changed slot refuses with 40001, which the app answers as "This plan changed. Preview again."
-- Two anchors, each exactly once; a re-run is a no-op (marker: 'kept selection changed').
do $migration$
declare
  definition text;
  anchors text[] := array[
    '    v_baseline := v_choice->''slotBaseline'';',
    '      raise exception ''plan selection changed'' using errcode = ''40001'';
    end if;'];
  replacements text[] := array[
    '    if v_choice ? ''keptSelectionId'' then
      if v_preview.kind <> ''shopping'' then
        raise exception ''invalid kept selection'' using errcode = ''22023'';
      end if;
      select * into v_selection from public.recipe_plan_selections
        where user_id=v_user and local_date=v_date and slot_id=v_choice->>''slotId'' for update nowait;
      if not found or v_selection.superseded_at is not null
        or v_selection.id::text is distinct from v_choice->>''keptSelectionId''
        or v_selection.plan_revision is distinct from (v_choice->>''expectedPlanRevision'')::integer
        or v_selection.recipe_revision_id::text is distinct from v_choice->>''recipeRevisionId''
        or v_selection.serving_fraction is distinct from (v_choice->>''servingFraction'')::numeric then
        raise exception ''kept selection changed'' using errcode = ''40001'';
      end if;
      v_selections := v_selections || jsonb_build_array(to_jsonb(v_selection));
      continue;
    end if;
    v_baseline := v_choice->''slotBaseline'';',
    '      raise exception ''plan selection changed'' using errcode = ''40001'';
    end if;
    if v_selection.id is not null and v_selection.superseded_at is null
      and (v_preview.kind = ''shopping'' or (v_choice ? ''expectedSelectionId''
        and v_selection.id::text is distinct from v_choice->>''expectedSelectionId'')) then
      raise exception ''accepted selection changed'' using errcode = ''40001'';
    end if;'];
  i integer;
begin
  select pg_get_functiondef('public.recipe_accept_preview(uuid,uuid,boolean)'::regprocedure)
    into definition;
  if position('kept selection changed' in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'recipe_accept_keeps_selection (recipe_accept_preview): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke all on function public.recipe_accept_preview(uuid,uuid,boolean) from public, anon;
grant execute on function public.recipe_accept_preview(uuid,uuid,boolean) to authenticated;
