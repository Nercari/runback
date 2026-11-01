### Changed

- **Fewer disk writes for replies (#144).** A publish now writes the inbox and only the 16 reply slots after the last one the addon loaded, instead of all 200: an hour of work writes about 23,200 files instead of 272,839, and no reply is lost. The addon adds its last loaded slot to the strip; an addon without it (or one that has not loaded a slot this session) still gets every slot written, and a `/reload` writes them all again before the next poll. A window of 16 is the measured value; a larger one needs a new measurement.
