### Added

- **Colourblind-safe map pins.** Pins on every map layer, and the herb and ore nodes, now use an Okabe-Ito based palette in which no two pin kinds look alike under deuteranopia or protanopia (the old palette had 7 of 91 kind pairs collapsing). `/runback map colors safe|classic` switches between it and the old colours, and the choice is saved in `RunbackMapDB`. The default is safe.
