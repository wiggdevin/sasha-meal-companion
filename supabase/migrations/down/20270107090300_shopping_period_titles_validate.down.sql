-- Validating a constraint has no down step of its own (the constraint itself is dropped by
-- 20270107090200's down file). No-op kept only so every migration has a matching down file.
select 1;
