# MFRC630 library provenance

This component contains the unmodified chip driver from
[iwanders/MFRC630](https://github.com/iwanders/MFRC630), pinned to commit
`577b0433a7dfae3fe3eba7a578d784982d90be69` (2020-11-13).

The upstream MIT license is in `LICENSE.txt`. ESP-IDF SPI support lives in the
separate `clrc663` component. Card protocol handling runs on the host; firmware
exposes only raw RF transceive and field control operations.
