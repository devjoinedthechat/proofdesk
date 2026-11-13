# Postmortems

Three accounts of things that went wrong while this system was built, chosen because each one changed how the rest was done. They are written without blame and with the detail needed to judge whether the fix was the right one.

| Postmortem                                                        | What it was                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [A refund limit that could be split around](0001-split-refund.md) | A control that judged one action, and an attack made of two              |
| [It worked in every test](0002-worked-in-every-test.md)           | Three gaps between what the tests wired up and what production would run |
| [Instruments that measured themselves](0003-instruments.md)       | Four measurements that were wrong before the thing they measured was     |
