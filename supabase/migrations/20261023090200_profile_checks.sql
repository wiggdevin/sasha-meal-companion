-- U6 (D3, F2): tighten the nullable profile fields already shipped by
-- 20261022090000_profile_targets.sql. NOT VALID avoids a table scan while each constraint is
-- installed; VALIDATE then proves every existing production row satisfies the new contract.

alter table user_settings
  add constraint user_settings_training_weekdays_valid_check
  check (
    training_weekdays is null or (
      training_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]
      and array_position(training_weekdays, null) is null
      and cardinality(training_weekdays) =
        (case when 0 = any(training_weekdays) then 1 else 0 end
         + case when 1 = any(training_weekdays) then 1 else 0 end
         + case when 2 = any(training_weekdays) then 1 else 0 end
         + case when 3 = any(training_weekdays) then 1 else 0 end
         + case when 4 = any(training_weekdays) then 1 else 0 end
         + case when 5 = any(training_weekdays) then 1 else 0 end
         + case when 6 = any(training_weekdays) then 1 else 0 end)
    )
  ) not valid;

alter table user_settings
  add constraint user_settings_diet_prefs_object_check
  check (diet_prefs is null or jsonb_typeof(diet_prefs) = 'object') not valid;

alter table user_settings
  validate constraint user_settings_training_weekdays_valid_check;

alter table user_settings
  validate constraint user_settings_diet_prefs_object_check;
