@WORKFLOW:
    CONTRACT 1
    # These bindings describe external observations; this tool does not fetch them.
    INPUT $CUSTOMER AS Customer FROM "request.customer"
    INPUT $MESSAGE AS Text FROM "request.locationCode"
    OUTPUT $RECEIPT AS SmsReceipt
    CONDITION $CAN_SEND AS $CUSTOMER.smsEnabled == true

    DECIDE $CAN_SEND:
        WHEN true:
            DO send_sms:
                NOTE Send the requested location code to the consenting customer.
                WITH to = $CUSTOMER.phone
                WITH body = $MESSAGE
                PRODUCES $RECEIPT
                ON success:
                    NOTE Retain $RECEIPT.id as evidence of provider acceptance.
                    EXIT SUCCESS
                ON failure:
                    NOTE The provider rejected the request; no successful receipt is promised.
                    EXIT FAILURE
                ON unknown:
                    NOTE Review the provider response before deciding whether to retry.
                    EXIT REVIEW
        WHEN false:
            NOTE Consent is absent; do not send the message.
            EXIT FAILURE
        WHEN unknown:
            NOTE Obtain reliable consent evidence before proceeding.
            EXIT REVIEW
