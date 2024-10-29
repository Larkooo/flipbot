import { TILE_HASHES } from "./constants"
import { Ty } from "./libs/dojo.c/dojo_c"

export enum Powerup {
    None,
    Multiplier,
  }
  
  export interface Tile {
    x: number
    y: number
    address: string
    powerup: Powerup
    powerupValue: number
    team: number
  }
  
  
  
  export function maskAddress(address: string) {
    const trimmed = address.substring(2).replace(/^0+/, '')
    return '0x' + trimmed.substring(0, trimmed.length - 4)
  }
  
  export function parseTileModel(model: Record<string, Ty>, hashedKeys?: string): Tile {
    const packedFlipped = model.flipped.value as string
    const address = packedFlipped !== '0x0' ? maskAddress(packedFlipped) : '0x0'
    const powerup =
      address !== '0x0'
        ? parseInt(packedFlipped.substring(packedFlipped.length - 4, packedFlipped.length - 3), 16)
        : Powerup.None
    const powerupValue =
      address !== '0x0' ? parseInt(packedFlipped.substring(packedFlipped.length - 3, packedFlipped.length - 1), 16) : 0
    const team =
      address !== '0x0' ? parseInt(packedFlipped.substring(packedFlipped.length - 1, packedFlipped.length), 16) : 0
  
    const x = (model.x?.value as number) ?? Math.floor(TILE_HASHES.indexOf(hashedKeys as string) / 256)
    const y = (model.y?.value as number) ?? TILE_HASHES.indexOf(hashedKeys as string) % 256
    return {
      x: x,
      y: y,
      address: address,
      powerup: powerup,
      powerupValue: powerupValue,
      team: team,
    }
  }