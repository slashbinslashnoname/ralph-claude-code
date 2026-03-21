import { app } from 'electron'
import * as path from 'path'

export function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png')
  }
  return path.join(__dirname, '../../resources/icon.png')
}
