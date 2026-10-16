# Authoring example only. This language has no runner.
# Draft assumption: STOP means stop the entire workflow on the first failure.
# Failure destination is described as the current spreadsheet row; choose its column before execution.
# Synthetic example: URLs and field names are illustrative placeholders.
@WORKFLOW:
    USING jev as a classifier wherever possible
    USING deterministic scripts for repeatable work; pause to write them before performing that work

    FOR EACH $RECORD IN https://example.invalid/sample-records:
        WHERE $RECORD's SMS Available value equals "No" and $RECORD's Status value equals "Waiting"

        DEFINE $LOCATION_CODE AS $RECORD's Location Code value

        DO open https://example.invalid/crm/locations
        THEN filter Location Code using $LOCATION_CODE
        THEN open the matching location preview

        IF the LOCATION SMS card appears AND its enabled icon is visible:
            DO open https://example.invalid/crm/leads
            THEN set the Location property to $LOCATION_CODE
            THEN refresh
            THEN open the lead sidebar

            IF the Lead SMS card appears:
                DO send an SMS with body equal to $LOCATION_CODE
            ELSE:
                NOTE in the current spreadsheet row: Lead SMS card is missing
                STOP @WORKFLOW
        ELSE:
            NOTE in the current spreadsheet row: LOCATION SMS card is missing or not enabled
            STOP @WORKFLOW
