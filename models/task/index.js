import { Config, Version, Render } from '#components'
import { Bot, logger, redis, segment } from '#lib'
import { api, db, utils } from '#models'
import _ from 'lodash'

let timer = null

// TODO: 改成sqlite?
const redisKey = 'steam-plugin:user-play:'

export function startTimer () {
  if (!Config.push.enable && !Config.push.stateChange) {
    return
  }
  clearInterval(timer)
  timer = setInterval(async () => {
    if (!Config.steam.apiKey) {
      return
    }
    logger.info('开始检查Steam游戏信息')
    try {
      // 获取现在的时间
      const now = Math.floor(Date.now() / 1000)
      // 从推送表中获取所有数据
      const PushData = await db.PushTableGetAllData(true)
      // 所有的steamId
      const steamIds = _.uniq(PushData.map(i => i.steamId))
      // 获取所有steamId现在的状态
      const result = await api.ISteamUser.GetPlayerSummaries(steamIds)
      const userList = {}
      for (const player of result) {
        // 获取上一次的状态
        let lastPlay = await redis.get(redisKey + player.steamid)
        if (lastPlay) {
          lastPlay = JSON.parse(lastPlay)
        } else {
          lastPlay = { name: '', appid: 0, state: 0, playTime: 0, onlineTime: 0 }
        }
        const state = {
          name: player.gameextrainfo,
          appid: player.gameid,
          state: player.personastate,
          playTime: lastPlay.time || lastPlay.playTime,
          onlineTime: lastPlay.time || lastPlay.onlineTime
        }
        // 如果这一次和上一次的状态不一样
        if (lastPlay.appid != player.gameid || lastPlay.state != player.personastate) {
          // 找到所有的推送群
          const pushGroups = PushData.filter(i => i.steamId === player.steamid)
          const iconUrl = utils.getHeaderImgUrlByAppid(player.gameid || lastPlay.appid)
          for (const i of pushGroups) {
            if (Version.BotName === 'Karin') {
              if (!Bot.getBot(i.botId)) {
                continue
              }
            } else if (!Bot[i.botId]) {
              continue
            }
            // 0 就是没有人绑定
            const nickname = i.userId == '0' ? player.personaname : await utils.getUserName(i.botId, i.userId, i.groupId)
            // 先收集所有要推送的用户
            if (!userList[i.groupId]) {
              userList[i.groupId] = {}
            }
            if (!userList[i.groupId][i.botId]) {
              userList[i.groupId][i.botId] = {
                start: [],
                end: [],
                state: []
              }
            }
            if (Config.push.enable && player.gameid && player.gameid != lastPlay.appid) {
              const time = now - lastPlay.playTime
              state.playTime = now
              userList[i.groupId][i.botId].start.push({
                name: player.gameextrainfo,
                appid: `${nickname}(${player.personaname})`,
                desc: lastPlay.playTime ? `距离上次 ${utils.formatDuration(time)}` : '',
                header_image: iconUrl
              })
              db.StatsTableUpdate(i.userId, i.groupId, i.botId, i.steamId, player.gameid, player.gameextrainfo, 'playTotal', 1).catch(e => logger.error('更新统计数据失败', e))
              db.HistoryAdd(i.userId, i.groupId, i.botId, i.steamId, now, null, player.gameid, player.gameextrainfo).catch(e => logger.error('添加历史记录失败', e))
            }
            if (Config.push.enable && lastPlay.name && lastPlay.name != player.gameextrainfo) {
              const time = now - lastPlay.playTime
              state.playTime = now
              userList[i.groupId][i.botId].end.push({
                name: lastPlay.name,
                appid: `${nickname}(${player.personaname})`,
                desc: `时长: ${utils.formatDuration(time)}`,
                header_image: utils.getHeaderImgUrlByAppid(lastPlay.appid)
              })
              db.StatsTableUpdate(i.userId, i.groupId, i.botId, i.steamId, lastPlay.appid, lastPlay.name, 'playTime', time).catch(e => logger.error('更新统计数据失败', e))
              db.HistoryAdd(i.userId, i.groupId, i.botId, i.steamId, lastPlay.playTime, now, lastPlay.appid, lastPlay.name).catch(e => logger.error('添加历史记录失败', e))
            }
            // 在线状态改变
            if (Config.push.stateChange && player.personastate != lastPlay.state) {
              const time = now - lastPlay.onlineTime
              if ([0, 1].includes(player.personastate)) {
                state.onlineTime = now
                userList[i.groupId][i.botId].state.push({
                  name: `${nickname}(${player.personaname})`,
                  appid: lastPlay.onlineTime ? `距离上次 ${utils.formatDuration(time)}` : '',
                  desc: `已${utils.getPersonaState(player.personastate)}`,
                  header_image: await utils.getUserAvatar(i.botId, i.userId, i.groupId) || (Config.other.steamAvatar ? i.avatarfull : ''),
                  header_image_class: 'square',
                  desc_style: `style="background-color: #${getColor(player.personastate)};color: white;width: fit-content;border-radius: 5px; padding: 0 5px;"`
                })
                if (player.personastate === 0) {
                  db.StatsTableUpdate(i.userId, i.groupId, i.botId, i.steamId, player.gameid, player.gameextrainfo, 'onlineTime', time).catch(e => logger.error('更新统计数据失败', e))
                  db.HistoryAdd(i.userId, i.groupId, i.botId, i.steamId, lastPlay.onlineTime, now).catch(e => logger.error('添加历史记录失败', e))
                } else {
                  db.StatsTableUpdate(i.userId, i.groupId, i.botId, i.steamId, player.gameid, player.gameextrainfo, 'onlineTotal', 1).catch(e => logger.error('更新统计数据失败', e))
                  db.HistoryAdd(i.userId, i.groupId, i.botId, i.steamId, now).catch(e => logger.error('添加历史记录失败', e))
                }
              } else {
                state.state = player.personastate === 0 ? 0 : 1
              }
            }
          }
        }
        redis.set(redisKey + player.steamid, JSON.stringify(state))
      }
      for (const gid in userList) {
        for (const botId in userList[gid]) {
          const i = userList[gid][botId]
          const data = []
          if (i.start.length) {
            if (Config.push.pushMode == 2) {
              data.push({
                title: '开始玩游戏的群友',
                games: i.start,
                size: 'large'
              })
            } else {
              data.push(...i.start.map(item => [segment.image(item.header_image), `[Steam] ${item.appid} 正在玩 ${item.name}\n${item.desc}`]))
            }
          }
          if (i.end.length) {
            if (Config.push.pushMode == 2) {
              data.push({
                title: '结束玩游戏的群友',
                games: i.end,
                size: 'large'
              })
            } else {
              data.push(...i.end.map(item => [segment.image(item.header_image), `[Steam] ${item.appid} 已结束游玩 ${item.name}\n${item.desc}`]))
            }
          }
          if (i.state.length) {
            if (Config.push.pushMode == 2) {
              data.push({
                title: '在线状态改变的群友',
                games: i.state,
                size: 'large'
              })
            } else {
              data.push(...i.state.map(item => [
                item.header_image ? segment.image(item.header_image) : '',
                `[Steam] ${item.name} ${item.desc} \n${item.appid}`
              ]))
            }
          }
          if (!data.length) {
            continue
          }
          if (Config.push.pushMode == 2) {
            const img = await Render.render('inventory/index', { data })
            await utils.sendGroupMsg(botId, gid, img)
          } else {
            for (const msg of data) {
              await utils.sendGroupMsg(botId, gid, msg)
            }
          }
        }
      }
    } catch (error) {
      logger.error('检查Steam游戏信息出现错误', error)
    }
  }, 1000 * 60 * Config.push.time)
}

// TODO:
function getColor (state) {
  switch (Number(state)) {
    case 1:
      return 'beee11'
    case 0:
      return '999999'
    default:
      return '8fbc8b'
  }
}
