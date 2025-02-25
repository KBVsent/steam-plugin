import { App, Render } from '#components'
import { api } from '#models'
import moment from 'moment'

const appInfo = {
  id: 'discounts',
  name: '优惠'
}

const rule = {
  discounts: {
    reg: App.getReg('(优惠|特惠|热销|新品|即将推出)'),
    cfg: {
      tips: true
    },
    fnc: async e => {
      const res = await api.store.featuredcategories()
      const items = [
        {
          title: '优惠',
          key: 'specials'
        },
        {
          title: '即将推出',
          key: 'coming_soon'
        },
        {
          title: '热销',
          key: 'top_sellers'
        },
        {
          title: '新品',
          key: 'new_releases'
        }
      ]
      const data = []
      for (const item of items) {
        const key = {
          title: item.title,
          games: []
        }
        for (const i of res[item.key].items) {
          key.games.push({
            appid: i.id,
            name: i.name,
            desc: i.discount_expiration ? moment.unix(i.discount_expiration).format('YYYY-MM-DD HH:mm:ss') : '',
            image: i.image,
            price: i.discounted
              ? {
                  original: `¥ ${i.original_price / 100}`,
                  discount: i.discount_percent,
                  current: `¥ ${i.final_price / 100}`
                }
              : {
                  original: i.original_price ? `¥ ${i.original_price / 100}` : ''
                }
          })
        }
        data.push(key)
      }
      const img = await Render.render('inventory/index', { data })
      await e.reply(img)
      return true
    }
  }
}

export const app = new App(appInfo, rule).create()
