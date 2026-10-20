import {Suspense} from 'react'
import {Yoinks} from '@/components/yoinks'

export default function Page() {
  return (
    <Suspense>
      <Yoinks />
    </Suspense>
  )
}
