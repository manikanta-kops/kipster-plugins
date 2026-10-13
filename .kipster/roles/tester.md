# Kipster Plugins tester additions

Follow the testing guide. Run `npm run check` for the fixture-service level. When a change touches the catalogue, sign-in discovery or the probe, run the live probe and attach its report. The probe stays read-only: no client registration, sign-in or tool calls. Never sign in to a real service. Report which levels ran, keep "probe" and "account" proof separate, and do not treat a vendor outage as a regression.
